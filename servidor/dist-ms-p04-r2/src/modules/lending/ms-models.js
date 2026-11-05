export const MS_POLICY = 'MS-MONTHLY-0.1.0';
export const MS_CONTRACT = '1.0.0';
export const isMonthlyLoan = (value) => Boolean(value && typeof value === 'object' && 'modality' in value && value.modality === 'MONTHLY_OPEN_V1');
//# sourceMappingURL=ms-models.js.map