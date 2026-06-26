export const store = {
  allProjects: [],
  allCases: [],
  allTasks: [],
  institutions: [],
  personnel: [],
  teams: [],
  notifications: [],
  parishSettings: null,
  // All parishes in the current group (id, parish_name, display_name,
  // principal_institution_id). Drives shared-tree heading labels and the
  // Add-Parish picker. Populated at load (main.js) + refreshed by admin ops.
  groupParishes: [],
  // The current parish GROUP row ({ id, name, display_name }). Its display_name
  // (when set) drives ONLY the nav header + login; blank → falls back to the
  // current parish full name. Populated at load (main.js).
  parishGroup: null,
  diocesanOverrides: [],
  currentUserProfile: null,
  currentUserRoles: null,
};
