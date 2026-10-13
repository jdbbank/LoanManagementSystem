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
