print("=== Clonando colecciones a _test (aggregate $out) ===");
var pairs = [["PanelCSTickets","PanelCSTickets_test"],["PanelCSCalls","PanelCSCalls_test"],["PanelCSMeta","PanelCSMeta_test"]];
pairs.forEach(function(p){
  var src=p[0], dst=p[1];
  var n = db.getCollection(src).countDocuments({});
  db.getCollection(src).aggregate([{$out: dst}]);
  var m = db.getCollection(dst).countDocuments({});
  print("  "+src+" ("+n+") -> "+dst+" ("+m+")");
});
print("\n=== Verificación: colecciones _test existen ===");
db.getCollectionNames().filter(function(c){return /_test$/.test(c)}).forEach(function(c){
  print("  "+c+": "+db.getCollection(c).countDocuments({})+" docs");
});
