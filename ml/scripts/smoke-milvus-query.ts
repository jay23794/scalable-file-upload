import { env } from '../src/config/env';
import { getMilvusClient } from '../src/infra/milvus';

async function main() {
  const client = getMilvusClient();
  const uploadId = process.argv[2];
  if (!uploadId) {
    console.error('usage: smoke-milvus-query.ts <uploadId>');
    process.exit(1);
  }

  const result = await client.query({
    collection_name: env.milvus.collection,
    filter: `upload_id == "${uploadId}"`,
    output_fields: ['pk', 'upload_id', 'chunk_index', 'text', 'created_at'],
  });

  console.log(`rows for uploadId=${uploadId}: ${result.data.length}`);
  for (const row of result.data) {
    console.log(row);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
