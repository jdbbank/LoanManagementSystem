import type { TFunction } from 'i18next';
import { InterestMethod } from '../api/types';

/** The option/table label for how a product prices interest. */
export const interestMethodName = (t: TFunction, method: InterestMethod | null | undefined): string =>
  method === InterestMethod.DECLINING ? t('products.methodDeclining') : t('products.methodFlat');

/** One sentence describing what that method charges, for forms and loan summaries. */
export const describeInterest = (t: TFunction, method: InterestMethod | null | undefined): string =>
  method === InterestMethod.DECLINING ? t('products.interestDeclining') : t('products.interestFlat');
