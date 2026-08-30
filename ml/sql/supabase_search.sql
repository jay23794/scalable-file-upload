-- Vector search for the RAG query path. Run once in the Supabase SQL editor,
-- after ml/sql/supabase_init.sql has created document_chunks.
--
-- Assumes 384-dim embeddings (Xenova/all-MiniLM-L6-v2). If EMBEDDING_DIM
-- differs, change vector(384) below to match — it must agree with the column
-- type created by supabase_init.sql.

-- Why `set hnsw.iterative_scan`:
--
-- pgvector's HNSW index searches by vector similarity FIRST and applies the
-- WHERE clause afterwards. With a selective filter — asking against 3 documents
-- out of 1000 — the index returns its best global candidates, nearly all of
-- which are then filtered out, so the function can return fewer rows than
-- match_count, or none at all, even when good matches exist in those 3
-- documents. Iterative scan keeps scanning until enough rows survive the filter.
--
-- Measured locally on pgvector 0.8.6 — 5000 chunks over 50 documents, filtered
-- to one document, match_count 5:
--
--   without iterative scan   1 row returned   (should have been 5)
--   relaxed_order            5 rows, approximately ranked
--   strict_order             5 rows, identical to an exact brute-force scan, 5.5ms
--
-- 'strict_order' is used because top-K here feeds an LLM prompt and a ranked
-- citation list, where both the membership and the order of the set are load
-- bearing. 'relaxed_order' is faster on large K; at K <= 20 the difference is
-- not measurable and correctness is worth more.
--
-- Requires pgvector >= 0.8.0. If your project is older, drop the SET clause and
-- raise hnsw.ef_search at the session level instead — but expect under-filled
-- results on narrow connector selections.

create or replace function match_document_chunks(
  query_embedding   vector(384),
  match_count       int,
  filter_upload_ids text[] default null
)
returns table (
  pk          text,
  upload_id   text,
  chunk_index int,
  text        text,
  score       float
)
language sql
stable
set hnsw.iterative_scan = 'strict_order'
as $$
  select
    c.pk,
    c.upload_id,
    c.chunk_index,
    c.text,
    -- <=> is cosine DISTANCE (0 = identical). Flip it so callers get
    -- similarity, matching the metric of the HNSW index in supabase_init.sql.
    1 - (c.embedding <=> query_embedding) as score
  from document_chunks c
  where filter_upload_ids is null
     or c.upload_id = any (filter_upload_ids)
  -- Must use the same operator as the index or Postgres falls back to a seq scan.
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
