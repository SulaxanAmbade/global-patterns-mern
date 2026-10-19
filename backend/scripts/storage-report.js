import { connect, client } from '../src/db.js';
// Read-only diagnostics. Never delete or change a collection here.
try {
  const db = await connect();
  const stats = [];
  for await (const collection of db.listCollections({}, { nameOnly: true })) {
    const s = await db.command({ collStats: collection.name, scale: 1 });
    stats.push({
      collection: collection.name,
      documents: s.count,
      dataMiB: +(s.size / 1048576).toFixed(2),
      indexesMiB: +(s.totalIndexSize / 1048576).toFixed(2),
      combinedMiB: +((s.size + s.totalIndexSize) / 1048576).toFixed(2),
    });
  }
  console.table(stats.sort((a, b) => b.combinedMiB - a.combinedMiB));
  console.log(
    'Read-only report for the configured database. Atlas quota can also include other databases in the cluster. No data was deleted.',
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
