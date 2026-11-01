import {AppError} from '../../shared/errors.js';
export const MAX_MONEY=999999999999999999n;
export function cents(value:unknown):bigint{
 if(typeof value!=='string'||! /^-?(0|[1-9][0-9]{0,15})\.[0-9]{2}$/.test(value)||value==='-0.00')throw new AppError(422,'INPUT_INVALID');
 const negative=value.startsWith('-'),digits=value.replace('-','').replace('.',''),result=BigInt(digits)*(negative?-1n:1n);checkMoney(result);return result;
}
export function checkMoney(value:bigint){if(value>MAX_MONEY||value< -MAX_MONEY)throw new AppError(422,'MONEY_OVERFLOW');return value;}
export function money(value:bigint){checkMoney(value);const negative=value<0n,n=negative?-value:value;return(negative?'-':'')+(n/100n)+'.'+(n%100n).toString().padStart(2,'0');}
export function fraction(value:unknown):bigint{
 if(typeof value!=='string'||value.length>8)throw new AppError(422,'INPUT_INVALID');
 const fields=value.split('.');
 if(fields.length>2||!['0','1'].includes(fields[0]!)||fields.length===2&&(!fields[1]||fields[1].length>6||[...fields[1]].some(c=>c<'0'||c>'9')||fields[0]==='1'&&[...fields[1]].some(c=>c!=='0')))throw new AppError(422,'INPUT_INVALID');
 const[whole,part='']=value.split('.');return BigInt(whole!)*1000000n+BigInt(part.padEnd(6,'0'));
}
export function rounded(numerator:bigint,denominator:bigint){if(denominator<=0n)throw new AppError(422,'INPUT_INVALID');const sign=numerator<0n?-1n:1n,n=numerator<0n?-numerator:numerator;return sign*((2n*n+denominator)/(2n*denominator));}
export const portion=(value:bigint,share:string)=>checkMoney(rounded(value*fraction(share),1000000n));
export function positive(value:unknown){const n=cents(value);if(n<=0n)throw new AppError(422,'INPUT_INVALID');return n;}
