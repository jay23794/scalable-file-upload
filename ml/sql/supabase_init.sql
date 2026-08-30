-- One-time Supabase setup for the ml vector store.
-- Run this in the Supabase SQL editor (or via psql) before starting the ml
-- service.
--
-- Assumes 384-dim embeddings (Xenova/all-MiniLM-L6-v2). If EMBEDDING_DIM
-- differs, change the vector(384) below to match.

create extension if not exists vector;

create table if not exists document_chunks (
  pk           text primary key,
  upload_id    text        not null,
  chunk_index  int         not null,
  text         text        not null,
  embedding    vector(384) not null,
  created_at   bigint      not null
);

create index if not exists document_chunks_upload_id_idx
  on document_chunks (upload_id);

create index if not exists document_chunks_embedding_idx
  on document_chunks using hnsw (embedding vector_cosine_ops);
