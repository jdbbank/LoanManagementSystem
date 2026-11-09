import { UserRole } from '../api/types';

export const OPERATOR_ROLES: UserRole[] = [
  UserRole.MAKER,
  UserRole.CHECKER,
  UserRole.HEAD_APPROVER,
  UserRole.ADMIN,
];

export const canCreate = (role: UserRole | undefined): boolean =>
  role === UserRole.MAKER || role === UserRole.ADMIN;

export const canApprove = (role: UserRole | undefined): boolean =>
  role === UserRole.CHECKER || role === UserRole.HEAD_APPROVER || role === UserRole.ADMIN;

/**
 * Releasing a guarantor, a payer or a pledge takes security away from a live loan, so it sits above the
 * maker's and the checker's desks — the same ceiling the server enforces on those routes.
 */
export const RELEASE_ROLES: UserRole[] = [UserRole.HEAD_APPROVER, UserRole.ADMIN];

export const canRelease = (role: UserRole | undefined): boolean =>
  role !== undefined && RELEASE_ROLES.includes(role);

export const isAdmin = (role: UserRole | undefined): boolean => role === UserRole.ADMIN;

export const canSeeReports = (role: UserRole | undefined): boolean =>
  role === UserRole.ADMIN || role === UserRole.HEAD_APPROVER;

export const ROLE_LABEL: Record<UserRole, string> = {
  [UserRole.ADMIN]: 'Admin',
  [UserRole.HEAD_APPROVER]: 'Head Approver',
  [UserRole.CHECKER]: 'Checker',
  [UserRole.MAKER]: 'Maker',
  [UserRole.VIEWER]: 'Viewer',
};
