import type {Row} from '../payments/models.js';
export const collectionTables=['collection_books','collection_journeys','collection_actions','cash_stations','cash_deliveries','cash_delivery_facts','cash_delivery_allocations','cash_close_records','collection_commands','collection_transitions'] as const;
export type CollectionTable=typeof collectionTables[number];
export const deliveryStates=['REQUESTED','IN_TRANSIT','RECEIVED_FOR_REVIEW','COUNTED','DISCREPANCY','INVESTIGATION','CORRECTED','CONFIRMED','RETURN_REQUIRED','RETURN_IN_TRANSIT','RETURN_RECEIVED','CANCELLED'] as const;
export type DeliveryState=typeof deliveryStates[number];
export const bucketNames=['confirmedOnSite','provisionalOnSite','returnRequiredOnSite','heldOnSite','inTransit','receivedUnposted','unlocatedDisputed','unidentifiedSurplus'] as const;
export type Buckets=Record<typeof bucketNames[number],string>;
export interface Portion {sourcePaymentId:string;sourceCustodyETag:string;amount:string}
export interface Delivery extends Row {
 kind:'FORWARD'|'COMPENSATION';originalDeliveryId:string|null;sourceAccountId:string;destinationAccountId:string;senderId:string;receiverId:string;stationId:string;journeyId:string|null;amount:string;portions:Portion[];state:DeliveryState;
 immutableIntentHash:string;countId:string|null;senderAckId:string|null;journalId:string|null;recordedAt:string;effectiveDate:string|null;compensatingDeliveryId:string|null;
 sequence:number;lastCount:string|null;receivedAt:string|null;investigated:boolean;returnFrom:DeliveryState|null;receiverNonReceipt:boolean;sourceRecalled:boolean;receiverReturnDispatched:boolean;sourceReceived:boolean;returnCount:string|null;lastFactHash:string|null;requestDate:string;
}
export interface Station extends Row {accountId:string;accountETag:string;receiverId:string;receiverETag:string;active:boolean;recordedAt:string}
export const policy={version:'S07-LOCAL-CO-0.1',usage:'LOCAL_SYNTHETIC',realUseAllowed:false,currency:'COP',zone:'America/Bogota',receiverRoles:['T','O'],confirmationRoles:['T'],heldRefunds:false,deliveryStates};
