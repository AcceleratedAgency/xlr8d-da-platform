db = db.getSiblingDB('admin');

db.createUser({
  user: 'da_manager',
  pwd: 't5czUaAKfOtKsfgCAUjUKnSTDlty7PJG',
  roles: [{ role: 'readWriteAnyDatabase', db: 'admin' }]
});
db.createUser({
  user: 'da_scheduler',
  pwd: 'yHGap2PBCzpIkraC4g0fP2mAOyvzY4e0',
  roles: [{ role: 'readWrite', db: 'da_platform_scheduler' }]
});