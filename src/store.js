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
  diocesanOverrides: [],
  currentUserProfile: null,
  currentUserRoles: null,
};
