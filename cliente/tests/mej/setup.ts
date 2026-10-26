import {beforeEach} from 'vitest';
// Fresh browser tab per case. Remounts inside a case retain pending logout.
beforeEach(()=>sessionStorage.removeItem('caudelyx-logout-pending'));
