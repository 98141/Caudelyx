import {AppError} from '../../shared/errors.js';

const ten=(n:number)=>10n**BigInt(n);
const digits=(n:bigint)=>(n<0n?-n:n).toString().length;
export function rounded(n:bigint,d:bigint,halfUp=false):bigint {
  if(d<=0n)throw new AppError(422,'CALCULATION_UNREPRESENTABLE');
  const sign=n<0n?-1n:1n,a=n*sign,q=a/d,r=a%d;
  return sign*(q+(r*2n>d||r*2n===d&&(halfUp||q%2n===1n)?1n:0n));
}
/** Bounded S04 decimal context: coefficient * 10^exponent, 60 significant digits, HALF_EVEN. */
export class Decimal60 {
  readonly c:bigint;readonly e:number;
  constructor(c:bigint,e=0){
    const shift=Math.max(0,digits(c)-60);
    this.c=shift?rounded(c,ten(shift)):c;this.e=c===0n?0:e+shift;
  }
  static text(s:string){const negative=s.startsWith('-'),v=negative?s.slice(1):s,parts=v.split('.');return new Decimal60(BigInt(parts.join(''))*(negative?-1n:1n),-(parts[1]?.length??0));}
  static fraction(n:bigint,d:bigint,exponent=0):Decimal60{
    if(d===0n)throw new AppError(422,'CALCULATION_UNREPRESENTABLE');
    if(n===0n)return new Decimal60(0n);
    const sign=(n<0n?-1n:1n)*(d<0n?-1n:1n);n=n<0n?-n:n;d=d<0n?-d:d;
    let order=digits(n)-digits(d);
    if(order>=0?n<d*ten(order):n*ten(-order)<d)order--;
    const e=order-59,c=e<0?rounded(n*ten(-e),d):rounded(n,d*ten(e));
    return new Decimal60(c*sign,e+exponent);
  }
  add(b:Decimal60){const e=Math.min(this.e,b.e);return new Decimal60(this.c*ten(this.e-e)+b.c*ten(b.e-e),e);}
  sub(b:Decimal60){return this.add(new Decimal60(-b.c,b.e));}
  mul(b:Decimal60){return new Decimal60(this.c*b.c,this.e+b.e);}
  div(b:Decimal60){return Decimal60.fraction(this.c,b.c,this.e-b.e);}
  pow(n:number){return n<0?Decimal60.fraction(1n,this.c**BigInt(-n),this.e*n):new Decimal60(this.c**BigInt(n),this.e*n);}
  cents(){return this.e+2>=0?this.c*ten(this.e+2):rounded(this.c,ten(-this.e-2),true);}
}
export function amount(c:bigint){const s=c<0n?'-':'',a=c<0n?-c:c;return s+(a/100n).toString()+'.'+(a%100n).toString().padStart(2,'0');}
export const cents=(s:string)=>BigInt(s.replace('.',''));
const weights=new Map<string,[bigint,bigint]>([['DAY',[1n,365n]],['WEEK',[7n,365n]],['FIFTEEN_DAYS',[15n,365n]],['SEMIMONTH',[1n,24n]],['MONTH',[1n,12n]],['YEAR',[1n,1n]]]);
const gcd=(a:bigint,b:bigint):bigint=>b===0n?a:gcd(b,a%b);
/** Certify i24 directly by exact rational powers and half-integer comparisons. No floating point/log/root approximation. */
export function periodicRate(rate:{type:string;unit:string;value:string;compoundingPeriodsPerYear?:number},frequency:string):string{
  const r=BigInt(rate.value.replace('.','')),scale=10n**24n,rs=10n**12n;
  if(r===0n)return '0.'+'0'.repeat(24);
  const pay=weights.get(frequency),unit=weights.get(rate.unit);
  if(!pay||!unit)throw new AppError(422,'INPUT_INVALID');
  const m=BigInt(rate.compoundingPeriodsPerYear??1);
  let p=rate.type==='EFFECTIVE'?pay[0]*unit[1]:pay[0]*m,q=rate.type==='EFFECTIVE'?pay[1]*unit[0]:pay[1];
  const g=gcd(p,q);p/=g;q/=g;
  const num=rate.type==='EFFECTIVE'?rs+r:rs*m+r,den=rate.type==='EFFECTIVE'?rs:rs*m;
  const np=num**p,dp=den**p,target=np*scale**q;
  let lo=scale,hi=scale*2n;
  while(hi**q*dp<=target)hi*=2n;
  while(hi-lo>1n){const mid=(hi+lo)/2n;if(mid**q*dp<=target)lo=mid;else hi=mid;}
  const midpoint=(2n*lo+1n)**q*dp,exact=np*(2n*scale)**q;
  const y=lo+(midpoint<exact||midpoint===exact&&lo%2n===1n?1n:0n),i=y-scale;
  return(i/scale).toString()+'.'+(i%scale).toString().padStart(24,'0');
}
