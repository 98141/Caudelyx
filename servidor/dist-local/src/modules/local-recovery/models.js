export const backupLimits = Object.freeze({ clear: 256 * 1024 * 1024, cipher: 512 * 1024 * 1024, component: 128 * 1024 * 1024, header: 65536, documents: 10000 });
export const componentKinds = ['SIGNED_PRINCIPAL_SNAPSHOT', 'EXTERNAL_MAIL_DATA', 'EXTERNAL_SECURITY_DATA', 'EXTERNAL_JOURNAL', 'EXTERNAL_CONTROL', 'PRIVATE_FILE', 'PRODUCT_KEYRING', 'CONFIGURATION'];
export class BackupError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'BackupError';
    }
}
export const fail = (code = 'BACKUP_INVALID') => { throw new BackupError(code); };
//# sourceMappingURL=models.js.map