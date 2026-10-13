import { lazy, Suspense } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import LoadingOverlay from './components/LoadingOverlay';
import { useAuth } from './auth/AuthContext';
import { useTranslation } from 'react-i18next';
import CustomersPage from './pages/CustomersPage';
import DashboardPage from './pages/DashboardPage';
import LoanDetailPage from './pages/LoanDetailPage';
import LoansPage from './pages/LoansPage';
import LoginPage from './pages/LoginPage';
import ProductsPage from './pages/ProductsPage';
const AdminPage = lazy(() => import('./pages/AdminPage'));
const ApprovalsPage = lazy(() => import('./pages/ApprovalsPage'));
const AuditPage = lazy(() => import('./pages/AuditPage'));
const CreditsPage = lazy(() => import('./pages/CreditsPage'));
const CustomerKycPage = lazy(() => import('./pages/CustomerKycPage'));
const PaymentRequestsPage = lazy(() => import('./pages/PaymentRequestsPage'));
const ReconciliationPage = lazy(() => import('./pages/ReconciliationPage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'));
const SettlementsPage = lazy(() => import('./pages/SettlementsPage'));
const TransactionsPage = lazy(() => import('./pages/TransactionsPage'));
const UsersPage = lazy(() => import('./pages/UsersPage'));

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { t } = useTranslation();
  if (loading) return <LoadingOverlay open label={t('common.loading')} />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  const { t } = useTranslation();
  const isMutating = useIsMutating();

  return (
    <>
      <Suspense fallback={<LoadingOverlay open label={t('common.loading')} />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<DashboardPage />} />
            <Route path="/customers" element={<CustomersPage />} />
            <Route path="/customers/:id" element={<CustomerKycPage />} />
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/loans" element={<LoansPage />} />
            <Route path="/loans/:id" element={<LoanDetailPage />} />
            <Route path="/payment-requests" element={<PaymentRequestsPage />} />
            <Route path="/transactions" element={<TransactionsPage />} />
            <Route path="/approvals" element={<ApprovalsPage />} />
            <Route path="/settlements" element={<SettlementsPage />} />
            <Route path="/credits" element={<CreditsPage />} />
            <Route path="/reconciliation" element={<ReconciliationPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/admin" element={<AdminPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <LoadingOverlay open={isMutating > 0} label={t('common.processing')} />
    </>
  );
}
