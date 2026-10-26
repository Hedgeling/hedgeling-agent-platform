function pruneConflict(blockingRows) {
  const workOrders = new Map();
  for (const row of blockingRows) {
    const workOrder = workOrders.get(row.work_order_id) || {
      id: row.work_order_id,
      workOrderNumber: row.work_order_number,
      title: row.title,
      status: row.status,
      sourceStrings: [],
    };
    workOrder.sourceStrings.push({
      id: row.source_string_id,
      sourceHash: row.source_hash,
    });
    workOrders.set(row.work_order_id, workOrder);
  }
  const blockingWorkOrders = [...workOrders.values()];
  const names = blockingWorkOrders
    .slice(0, 10)
    .map((workOrder) => `#${workOrder.workOrderNumber} ${workOrder.title}`)
    .join(", ");
  const suffix = blockingWorkOrders.length > 10
    ? ` and ${blockingWorkOrders.length - 10} more`
    : "";
  const error = new Error(
    `Cannot prune source strings referenced by work orders: ${names}${suffix}`,
  );
  error.status = 409;
  error.code = "import_prune_work_order_conflict";
  error.details = { blockingWorkOrders };
  return error;
}

export async function pruneMissingProjectSources(
  client,
  {
    projectId,
    importedSourceHashes,
    emptyImportMessage = "pruneMissing requires at least one source string in the import state",
  },
) {
  const hashes = [...importedSourceHashes];
  if (hashes.length === 0) {
    const error = new Error(emptyImportMessage);
    error.status = 400;
    error.code = "import_prune_empty";
    throw error;
  }

  // Lock every deletion candidate before checking references. A concurrent
  // work-order attachment needs a key-share lock on the source row, so it
  // cannot appear between this preflight and the delete.
  const candidates = await client.query(
    `select id, source_hash
     from source_strings
     where project_id = $1
       and not (source_hash = any($2::text[]))
     order by source_hash
     for update`,
    [projectId, hashes],
  );
  if (candidates.rowCount === 0) return 0;

  const candidateIds = candidates.rows.map((row) => row.id);
  const blockers = await client.query(
    `select work_order.id as work_order_id,
            work_order.work_order_number,
            work_order.title,
            work_order.status,
            source.id as source_string_id,
            source.source_hash
     from work_order_items item
     join work_orders work_order on work_order.id = item.work_order_id
     join source_strings source on source.id = item.source_string_id
     where item.source_string_id = any($1::uuid[])
     order by work_order.work_order_number, work_order.id, source.source_hash`,
    [candidateIds],
  );
  if (blockers.rows.length > 0) throw pruneConflict(blockers.rows);

  const deleted = await client.query(
    "delete from source_strings where id = any($1::uuid[])",
    [candidateIds],
  );
  return deleted.rowCount || 0;
}
