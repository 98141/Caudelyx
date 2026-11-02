/* eslint-disable security/detect-non-literal-fs-filename -- Operator-configured private root and server UUID only; realpath/lstat containment for every operation. */
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../shared/errors.js';
import { binaryHash } from './canonical.js';
const fail = (code = 'INTEGRITY_MISMATCH') => { throw new AppError(503, code); };
export class PrivateStorage {
    root;
    constructor(root) { if (!path.isAbsolute(root))
        throw Error('Private storage must be absolute operator configuration'); this.root = path.resolve(root); }
    async guard() {
        let p = path.parse(this.root).root;
        for (const bit of this.root.slice(p.length).split(path.sep).filter(Boolean)) {
            p = path.join(p, bit);
            const stat = await fs.lstat(p);
            if (stat.isSymbolicLink() || !stat.isDirectory())
                fail();
        }
        if (path.resolve(await fs.realpath(this.root)).toLowerCase() !== this.root.toLowerCase())
            fail();
    }
    filename(id, suffix = '') {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
            throw new AppError(422, 'INPUT_INVALID');
        const p = path.resolve(this.root, id + suffix);
        if (path.dirname(p) !== this.root)
            fail();
        return p;
    }
    async publish(id, bytes) {
        await this.guard();
        const filename = this.filename(id), temp = this.filename(id, '.part');
        if (bytes.length > 33554432)
            throw new AppError(413, 'FILE_LIMIT_EXCEEDED');
        let handle, created = false;
        try {
            handle = await fs.open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
            created = true;
            await handle.writeFile(bytes);
            await handle.sync();
            await handle.close();
            handle = undefined;
            // The exclusive .part object is also the per-UUID publication lock. Every
            // product writer must acquire it before inspecting the destination. Keep it
            // until rename completes; a competing publisher cannot pass this lock.
            try {
                await fs.lstat(filename);
                throw new AppError(409, 'SOURCE_CONFLICT');
            }
            catch (err) {
                if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT'))
                    throw err;
            }
            await this.guard();
            await fs.rename(temp, filename);
            return { bytes: bytes.length, sha256: binaryHash(bytes) };
        }
        finally {
            await handle?.close();
            if (created)
                try {
                    await fs.unlink(temp);
                }
                catch (err) {
                    if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT'))
                        throw err;
                }
        }
    }
    async read(id, expected) {
        await this.guard();
        const file = this.filename(id);
        let handle;
        try {
            const before = await fs.lstat(file);
            if (!before.isFile() || before.isSymbolicLink() || before.size !== expected.bytes || before.size > 33554432 || path.resolve(await fs.realpath(file)).toLowerCase() !== file.toLowerCase())
                fail();
            handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            const stat = await handle.stat();
            if (stat.size !== before.size || stat.ino !== before.ino)
                fail();
            const bytes = await handle.readFile();
            const after = await handle.stat();
            if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || binaryHash(bytes) !== expected.sha256)
                fail();
            return bytes;
        }
        catch (err) {
            if (err instanceof AppError)
                throw err;
            return fail();
        }
        finally {
            await handle?.close();
        }
    }
    async remove(id) {
        await this.guard();
        for (const suffix of ['', '.part']) {
            const file = this.filename(id, suffix);
            try {
                const stat = await fs.lstat(file);
                if (!stat.isFile() || stat.isSymbolicLink() || path.resolve(await fs.realpath(file)).toLowerCase() !== file.toLowerCase())
                    fail();
                await fs.unlink(file);
            }
            catch (err) {
                if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT'))
                    throw err;
            }
        }
    }
    async has(id) { await this.guard(); for (const suffix of ['', '.part'])
        try {
            const p = this.filename(id, suffix), stat = await fs.lstat(p);
            if (!stat.isFile() || stat.isSymbolicLink() || path.resolve(await fs.realpath(p)).toLowerCase() !== p.toLowerCase())
                fail();
            return true;
        }
        catch (err) {
            if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT'))
                throw err;
        } return false; }
}
//# sourceMappingURL=storage.js.map