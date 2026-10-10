// Limits for the tasks module. Every value has a unit and a reason.

// Creating tasks is rare and deliberate; 200 a day per person leaves room for importing a course's
// worth of problems and stops a script from filling the organization's 1,000-task allowance in minutes.
export const TASKS_CREATED_PER_USER_PER_DAY_MAX = 200;
