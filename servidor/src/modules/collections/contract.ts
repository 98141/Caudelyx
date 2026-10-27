import {paymentContract,paymentDocument} from '../payments/contract.js';
const spec=paymentDocument();
export const collectionClasses=spec['x-purpose-catalog-s07-delta'];
export const isCollectionPurpose=(purpose:unknown):purpose is string=>typeof purpose==='string'&&Object.hasOwn(collectionClasses,purpose);
export const collectionOperations=new Set([...paymentContract().operations].filter(([,operation])=>operation.path.split('/').some(p=>/^(collections|collection-|cash-stations|cash-positions|cash-deliver)/.test(p))||operation.path.includes('/cash-closes')).map(([id])=>id));
export const collectionContract=paymentContract;
