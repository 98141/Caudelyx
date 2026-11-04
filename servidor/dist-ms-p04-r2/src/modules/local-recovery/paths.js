/* eslint-disable security/detect-non-literal-fs-filename -- Exact leased synthetic group and fixed child directories, never HTTP paths. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fail } from './models.js';
function lexical(p) { if (!path.isAbsolute(p) || p.length > 240 || p.startsWith('\\\\?\\') || p.startsWith('\\\\.\\') || p.replace(/^[A-Za-z]:/, '').includes(':') || p.split(/[\\/]/).some(s => s === '.' || s === '..' || /[ .]$/.test(s) || /~[0-9]/.test(s)))
    fail('BACKUP_PATH'); }
async function canonical(p) { const s = await fs.lstat(p); if (s.isSymbolicLink() || await fs.realpath(p) !== p)
    fail('BACKUP_PATH'); return s; }
export async function owned(group) {
    lexical(group.folder);
    const runtime = path.resolve('.runtime');
    if (path.dirname(group.folder) !== runtime || !/^(?:s13-p(?:02|04|05)|ms-p(?:02|04))-[a-f0-9]{24}$/.test(path.basename(group.folder)))
        fail('BACKUP_OWNERSHIP');
    const id = group.folder.slice(-24), principal = 'caudelyx_s08_p02_' + id;
    if (JSON.stringify(group.names) !== JSON.stringify([principal, principal + '_external_mail', principal + '_external_security']))
        fail('BACKUP_OWNERSHIP');
    if (!(await canonical(runtime)).isDirectory() || !(await canonical(group.folder)).isDirectory())
        fail('BACKUP_PATH');
    const file = path.join(group.folder, 'owner.json');
    if (!(await canonical(file)).isFile())
        fail('BACKUP_PATH');
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    if (record['pid'] !== process.pid || record['id'] !== id || record['runId'] !== group.runId || record['nonce'] !== group.nonce || JSON.stringify(record['names']) !== JSON.stringify(group.names))
        fail('BACKUP_OWNERSHIP');
}
export async function ownedPath(group, target) {
    lexical(target);
    await owned(group);
    const relative = path.relative(group.folder, target);
    if (!relative || path.isAbsolute(relative) || relative.startsWith('..'))
        fail('BACKUP_PATH');
    let cursor = group.folder, missing = false;
    for (const bit of relative.split(path.sep)) {
        cursor = path.join(cursor, bit);
        if (missing)
            continue;
        try {
            await canonical(cursor);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            missing = true;
        }
    }
    return target;
}
export async function privateDirectory(group, name) {
    const directory = path.join(group.folder, name);
    await ownedPath(group, directory);
    await fs.mkdir(directory, { mode: 0o700, recursive: true });
    await ownedPath(group, directory);
    await restrict(directory);
    return directory;
}
export async function exclusiveFile(group, target, bytes, signal) {
    signal?.throwIfAborted();
    await ownedPath(group, target);
    const handle = await fs.open(target, 'wx', 0o600);
    try {
        signal?.throwIfAborted();
        await handle.writeFile(bytes, { signal });
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
export async function boundedFile(group, target, maxBytes) {
    await ownedPath(group, target);
    const before = await fs.lstat(target);
    if (!before.isFile() || before.size > maxBytes)
        fail('BACKUP_LIMIT');
    const handle = await fs.open(target, 'r');
    try {
        const s = await handle.stat();
        if (s.ino !== before.ino || s.size !== before.size)
            fail('BACKUP_PATH');
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (bytes.length !== before.size || after.size !== s.size || after.mtimeMs !== s.mtimeMs)
            fail('BACKUP_STATE');
        return bytes;
    }
    finally {
        await handle.close();
    }
}
async function restrict(directory) {
    if (process.platform === 'win32') {
        // No key or credential is passed through a shell or environment. Only the guarded path.
        const script = "$ErrorActionPreference='Stop'; $p=$env:CAUDELYX_S13_PRIVATE_DIR; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); $directory=New-Object System.IO.DirectoryInfo($p); $directory.SetAccessControl($acl); $got=$directory.GetAccessControl(); if(-not $got.AreAccessRulesProtected){throw 'Private ACL not protected'}; foreach($entry in $got.Access){if($entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'Unexpected ACL principal'}}; Write-Output 'PRIVATE_OWNER_ONLY'";
        const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, CAUDELYX_S13_PRIVATE_DIR: directory }, windowsHide: true, timeout: 10000, maxBuffer: 4096 });
        if (result.stdout.trim() !== 'PRIVATE_OWNER_ONLY')
            fail('BACKUP_OWNERSHIP');
    }
    else {
        await fs.chmod(directory, 0o700);
        if (((await fs.stat(directory)).mode & 0o077) !== 0)
            fail('BACKUP_OWNERSHIP');
    }
}
export async function protectGroup(group) { await owned(group); await restrict(group.folder); }
//# sourceMappingURL=paths.js.map