const {
  useAccessControl
} = require('../config/email_constants');


const getAuthzFlags = (request) => {
  const isAuthenticated = !!request.auth.credentials?.id;
  const isAdmin = isAuthenticated && request.auth.credentials.scope.includes('admin');
  return [isAuthenticated, isAdmin];
};

const initializeQuery = (request, entityType) => {
  const [isAuthenticated, isAdmin] = getAuthzFlags(request);
  const hiddenField = `${entityType}_hidden`;
  const accessListField = `${entityType}_access_list`;
  const query = { [hiddenField]: false };

  // Admins always see everything
  if (isAdmin) {
    delete query[hiddenField];
    return query;
  }

  // ACLs may retrieve some hidden if on allowed list.
  if (useAccessControl && isAuthenticated) {
    delete query[hiddenField];
    query.$or = [{ [hiddenField]: false }, { [accessListField]: request.auth.credentials.id }];
    return query;
  }

  return query;
};

const checkEntityAccess = (entity, entityType, request) => {
  const hiddenField = `${entityType}_hidden`;
  const accessListField = `${entityType}_access_list`;
  const [isAuthenticated, isAdmin] = getAuthzFlags(request);

  if (!entity[hiddenField] || isAdmin) return true;

  if (!isAuthenticated) return false;

  const isOnAccessList = (entity[accessListField] || []).includes(request.auth.credentials.id);

  if (useAccessControl && isOnAccessList) return true;

  return false;
};

module.exports = {
  initializeQuery,
  checkEntityAccess
};
