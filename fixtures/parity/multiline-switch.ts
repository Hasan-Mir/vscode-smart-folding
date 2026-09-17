// Parity fixture: switch statements with multiline headers must fold case
// clauses — and object literals with switch/default-looking keys must not.
export function classify(value: number): string {
    switch (value) {
        case 0:
            return 'zero';
        default:
            return 'many';
    }
}

const obj = {
    switch: true,
    default: 1,
    value: 2,
};
