// Some deployed Atlas clusters are at their collection limit. These logical
// stores can share an existing internal collection without touching its rows.
const { fail } = require('./accountAccess');
const NAMES = new Set(['appraisal_partners','appraisal_invitations','appraisal_media','iappraise_archive','floor_vehicle_requests','floor_vehicle_checks']);
const MARKER = 'appraisal_namespace';
function storage(db) {
  const shared = process.env.APPRAISAL_STATE_COLLECTION;
  if (!shared) return db;
  if (!/^[a-zA-Z0-9_]{1,80}$/.test(shared) || NAMES.has(shared)) fail(500,'Invalid shared appraisal collection configuration.');
  const physical = db.collection(shared);
  const clean = row => { if (!row) return row; const { [MARKER]: ignored, ...value } = row; return value; };
  return { collection(name) {
    if (!NAMES.has(name)) return db.collection(name);
    const scope = query => ({ ...(query || {}), [MARKER]: name });
    return {
      async findOne(query,options) { return clean(await physical.findOne(scope(query),options)); },
      find(query,options) {
        let cursor=physical.find(scope(query),options);
        const view={sort(value){cursor=cursor.sort(value);return view;},skip(value){cursor=cursor.skip(value);return view;},limit(value){cursor=cursor.limit(value);return view;},async toArray(){return (await cursor.toArray()).map(clean);}};
        return view;
      },
      countDocuments(query,options) { return physical.countDocuments(scope(query),options); },
      insertOne(document,options) { return physical.insertOne({...document,[MARKER]:name},options); },
      updateOne(query,update,options) {
        if (update.$set?.[MARKER] || update.$unset?.[MARKER] || update.$rename?.[MARKER]) fail(400,'Appraisal storage namespace is immutable.');
        return physical.updateOne(scope(query),{...update,$setOnInsert:{...update.$setOnInsert,[MARKER]:name}},options);
      },
      updateMany(query,update,options) { if(update.$set?.[MARKER] || update.$unset?.[MARKER])fail(400,'Appraisal storage namespace is immutable.');return physical.updateMany(scope(query),update,options); },
      deleteOne(query,options) { return physical.deleteOne(scope(query),options); },
      indexes() { return physical.indexes(); },
      createIndex(index,options) { return physical.createIndex({[MARKER]:1,...index},options); },
    };
  }};
}
module.exports={storage,NAMES,MARKER};
