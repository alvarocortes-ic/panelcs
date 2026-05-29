// Diagnóstico panorama Panel CS — estado vivo Mongo (cluster 2, BD automatizaciones)
print("=== PanelCSMeta (cursors/meta) ===");
db.PanelCSMeta.find().forEach(d => printjson(d));

print("\n=== Conteo total PanelCSTickets ===");
print(db.PanelCSTickets.countDocuments({}));

print("\n=== Por _syncSource ===");
db.PanelCSTickets.aggregate([{$group:{_id:"$_syncSource", n:{$sum:1}}},{$sort:{n:-1}}]).forEach(d=>printjson(d));

print("\n=== Campos de un doc de ejemplo ===");
var s = db.PanelCSTickets.findOne();
print(Object.keys(s).sort().join(", "));

print("\n=== Cobertura enrich (countDocuments con campo != null) ===");
["frtMin","slaBreached","slaActiveBreaches","solvedAt","reopens","groupId","assigneeId","organizationId"].forEach(f=>{
  var q={}; q[f]={$ne:null};
  try { print(f+": "+db.PanelCSTickets.countDocuments(q)); } catch(e){ print(f+": ERR "+e); }
});

print("\n=== Frescura: max por timestamps comunes ===");
["updatedAt","_syncedAt","updated_at","solvedAt","createdAt"].forEach(f=>{
  var sort={}; sort[f]=-1;
  var d=db.PanelCSTickets.find({}).sort(sort).limit(1).toArray()[0];
  if(d && d[f]!==undefined) print(f+" max: "+JSON.stringify(d[f]));
});

print("\n=== Docs por origen Schedule vs seed ===");
print("cs-data-v2-schedule: "+db.PanelCSTickets.countDocuments({_syncSource:"cs-data-v2-schedule"}));
print("populate_mongo_from_seed.py: "+db.PanelCSTickets.countDocuments({_syncSource:"populate_mongo_from_seed.py"}));

print("\n=== PanelCSCalls (Aircall) resumen ===");
print("total: "+db.PanelCSCalls.countDocuments({}));
var c = db.PanelCSCalls.findOne();
if(c) print("campos: "+Object.keys(c).sort().join(", "));
