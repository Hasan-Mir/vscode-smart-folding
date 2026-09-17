// Parity fixture: braceless multi-line imports still form one imports run.
import * as path from
    'node:path';
import * as fs from
    'node:fs';
import { readFile } from 'fs';

export const paths = [path, fs, readFile];