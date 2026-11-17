#!/usr/bin/env node
// What `npm link` puts on the PATH as `cw`: scripts/cw.ts, run through tsx like every other script here.
import { register } from 'tsx/esm/api';

register();
await import('../scripts/cw.ts');
