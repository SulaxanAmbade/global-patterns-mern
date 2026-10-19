export function isStorageQuotaError(error) {
  return /over.{0,30}space quota|storage quota|writes are blocked on your cluster/i.test(
    String(error?.message || error?.errmsg || ''),
  );
}
export const storageQuotaMessage =
  'MongoDB storage is full. Free database space or use a larger/local MongoDB database, then restart the backend and retry. Increasing MAX_UPLOAD_MB does not increase database capacity.';

// A second write may also fail after a worker runs out of database space.
// Event callbacks must resolve without throwing an unhandled rejection.
export async function recordJobFailure(db, id, message, runningOnly = false) {
  try {
    await db
      .collection('jobs')
      .updateOne(
        { _id: id, ...(runningOnly ? { status: 'running' } : {}) },
        { $set: { status: 'failed', error: message, finishedAt: new Date() } },
      );
    return true;
  } catch (error) {
    console.error(
      'Could not save job failure:',
      isStorageQuotaError(error) ? storageQuotaMessage : error.message,
    );
    return false;
  }
}
