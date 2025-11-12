const {
  useAccessControl
} = require('../config/email_constants');


const requestAuthReduce = (request) => {
  const isAuthenticated = !!request.auth.credentials?.id;
  const isAdmin = isAuthenticated && request.auth.credentials.scope.includes('admin');
  const wantsHidden = request.query.hidden === true;
  return [isAuthenticated, isAdmin, wantsHidden];
};

const initializeQuery = (request, entityType) => {
  const [isAuthenticated, isAdmin, wantsHidden] = requestAuthReduce(request);
  const hiddenField = `${entityType}_hidden`;
  const accessListField = `${entityType}_access_list`;
  const query = { [hiddenField]: false };

  // Admins always get what they want.
  if (isAdmin) {
    // Do not specify in query in order to return everything
    if (wantsHidden) {
      delete query[hiddenField];
    }

    return query;
  }

  // Should not be asking for hidden otherwise.
  if (wantsHidden) {
    return undefined;
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
  const [isAuthenticated, isAdmin] = requestAuthReduce(request);

  if (!entity[hiddenField] || isAdmin) return true;

  if (!isAuthenticated) return false;

  const isOnAccessList = (entity[accessListField] || []).includes(request.auth.credentials.id);

  if (useAccessControl && isOnAccessList) return true;

  return false;
};

module.exports = {
  requestAuthReduce,
  initializeQuery,
  checkEntityAccess
};
