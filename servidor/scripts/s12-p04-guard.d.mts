export const projectRoot:string;
export function assertWritable(target:string,root?:string):Promise<string>;
export function mkdirOwn(target:string,root?:string):Promise<void>;
export function writeOwn(target:string,data:string|Buffer,root?:string,options?:unknown):Promise<void>;
export function appendOwn(target:string,data:string,root?:string):Promise<void>;
