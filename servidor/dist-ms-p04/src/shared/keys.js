import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
export async function loadSyntheticKeys(path) {
    let raw;
    try {
        // Operator-supplied local config path, never HTTP input; synthetic key file excluded from source control.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        raw = await readFile(path, 'utf8');
    }
    catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
            throw error;
        const generated = { version: 2, priority: randomBytes(32).toString('base64url'), mail: randomBytes(32).toString('base64url'), totp: randomBytes(32).toString('base64url'),
            journal: randomBytes(32).toString('base64url'), cursor: randomBytes(32).toString('base64url') };
        // Same trusted local configuration path, not request input.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        await mkdir(dirname(path), { recursive: true });
        const temporary = path + '.' + randomUUID() + '.tmp';
        // Write fully before linking: no second instance can observe a half-written keyring.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        await writeFile(temporary, JSON.stringify(generated), { flag: 'wx', mode: 0o600 });
        try {
            // eslint-disable-next-line security/detect-non-literal-fs-filename
            await link(temporary, path);
        }
        catch (writeError) {
            if (!(writeError instanceof Error) || !('code' in writeError) || writeError.code !== 'EEXIST')
                throw writeError;
        }
        finally {
            // Delete only the exact temporary file created above, never recursively.
            // eslint-disable-next-line security/detect-non-literal-fs-filename
            await unlink(temporary);
        }
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        raw = await readFile(path, 'utf8');
    }
    const data = JSON.parse(raw);
    const readKey = (name) => {
        // Key names come only from the fixed allowlist below.
        // eslint-disable-next-line security/detect-object-injection
        const value = data[name];
        if (typeof value !== 'string')
            throw new Error('Invalid synthetic keyring');
        const key = Buffer.from(value, 'base64url');
        if (key.length !== 32)
            throw new Error('Invalid synthetic key size');
        return key;
    };
    if (data['version'] !== 1 && data['version'] !== 2)
        throw new Error('Unsupported synthetic key version');
    return { version: data['version'], ...(data['version'] === 2 ? { priority: readKey('priority') } : {}), mail: readKey('mail'), totp: readKey('totp'), journal: readKey('journal'), cursor: readKey('cursor') };
}
//# sourceMappingURL=keys.js.map