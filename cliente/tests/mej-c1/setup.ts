import {beforeEach,afterEach,vi} from 'vitest';
import {resetSessionMemory,bumpSessionEpoch} from '../../src/shared/api';
beforeEach(()=>{sessionStorage.clear();resetSessionMemory();bumpSessionEpoch();window.location.hash='#/finanzas';});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
