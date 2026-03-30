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

const annotateAccessDenied = (entities, entityType, request) => {

  return entities.map((entity) => {

    if (!checkEntityAccess(entity, entityType, request)) {
      entity.access_denied = true;
    }

    return entity;
  });
};

// Find the cruise whose time range encompasses the given lowering.
// Returns the cruise document or null.
const findParentCruise = async (db, cruisesTable, lowering) => {

  return db.collection(cruisesTable).findOne({
    start_ts: { $lte: lowering.start_ts },
    stop_ts: { $gte: lowering.stop_ts }
  });
};

// For lowering listings: if the parent cruise is hidden and the user
// cannot access it, mark the lowering as access_denied.
const annotateCruiseAccessDenied = async (lowerings, db, cruisesTable, request) => {

  // Fetch all hidden cruises once
  const hiddenCruises = await db.collection(cruisesTable).find({ cruise_hidden: true }).toArray();

  if (hiddenCruises.length === 0) {
    return lowerings;
  }

  lowerings.forEach((lowering) => {

    // Already denied by lowering-level check, skip
    if (lowering.access_denied) {
      return;
    }

    // Check if this lowering falls within any hidden cruise
    const parentCruise = hiddenCruises.find((cruise) =>
      cruise.start_ts <= lowering.start_ts && cruise.stop_ts >= lowering.stop_ts
    );

    if (parentCruise && !checkEntityAccess(parentCruise, 'cruise', request)) {
      lowering.access_denied = true;
    }
  });

  return lowerings;
};

// Return time ranges of hidden lowerings inside a cruise that the
// requesting user cannot access.  Used by bycruise event handlers to
// exclude events that fall within embargoed dives.
const getHiddenLoweringRanges = async (db, loweringsTable, cruise, request) => {

  const [, isAdmin] = getAuthzFlags(request);
  if (isAdmin) return [];

  const hiddenLowerings = await db.collection(loweringsTable).find({
    lowering_hidden: true,
    start_ts: { $gte: cruise.start_ts },
    stop_ts: { $lte: cruise.stop_ts }
  }).toArray();

  if (hiddenLowerings.length === 0) return [];

  return hiddenLowerings
    .filter((l) => !checkEntityAccess(l, 'lowering', request))
    .map((l) => ({ start_ts: l.start_ts, stop_ts: l.stop_ts }));
};

// Strip all fields from access_denied entities except id and the
// human-readable identifier (cruise_id / lowering_id).
const sanitizeUnauthorizedFields = (entities, entityType) => {

  const idField = `${entityType}_id`;
  const toDateOnly = (ts) => ts ? new Date(ts).toISOString().split('T')[0] + 'T00:00:00.000Z' : undefined;

  return entities.map((entity) => {

    if (!entity.access_denied) {
      return entity;
    }

    // Flatten timestamps to date only (strip time component)
    const sanitized = { id: entity.id, [idField]: entity[idField], start_ts: toDateOnly(entity.start_ts), access_denied: true };
    if (entityType === 'cruise') {
      sanitized.stop_ts = toDateOnly(entity.stop_ts);
    }

    return sanitized;
  });
};

// Returns true if the event's timestamp falls within any of the given ranges.
const isEventInHiddenRange = (event, hiddenRanges) =>
  hiddenRanges.some((range) => event.ts >= range.start_ts && event.ts <= range.stop_ts);

module.exports = {
  initializeQuery,
  checkEntityAccess,
  annotateAccessDenied,
  annotateCruiseAccessDenied,
  findParentCruise,
  getHiddenLoweringRanges,
  sanitizeUnauthorizedFields,
  isEventInHiddenRange
};
