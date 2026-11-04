import * as argon2 from 'argon2';
import { opaque } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
export class PasswordHasher {
    active = 0;
    waiters = [];
    dummy = '';
    async initialize() { this.dummy = await this.hash(opaque() + opaque()); }
    validate(password, context = []) {
        if ([...password].length < 15 || [...password].length > 128 || Buffer.byteLength(password, 'utf8') > 1024) {
            throw new AppError(422, 'INPUT_INVALID');
        }
        const key = password.toLowerCase();
        const blocklist = ['passwordpassword', '123456789012345', 'caudelyxcaudelyx', ...context.map(s => s.toLowerCase())];
        if (blocklist.includes(key))
            throw new AppError(422, 'INPUT_INVALID');
    }
    async bounded(work) {
        if (this.active >= 2) {
            if (this.waiters.length >= 8)
                throw new AppError(503, 'SERVICE_UNAVAILABLE');
            await new Promise(resolve => this.waiters.push(resolve));
        }
        else
            this.active++;
        try {
            return await work();
        }
        finally {
            const next = this.waiters.shift();
            if (next)
                next();
            else
                this.active--;
        }
    }
    async hash(password) {
        return await this.bounded(async () => await argon2.hash(password, {
            type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1,
        }));
    }
    async verify(hash, password) {
        if (!this.dummy)
            throw new AppError(503, 'SERVICE_UNAVAILABLE');
        const result = await this.bounded(async () => await argon2.verify(hash ?? this.dummy, password));
        return hash !== null && result;
    }
}
//# sourceMappingURL=password.js.map