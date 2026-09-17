// Parity fixture: a call whose argument list spans lines, followed by a
// standalone block. The block folds from its OWN line — the `)` above it is a
// continuation tail, not a statement header (Allman walk-back refinement).
const message = format(
    'value',
    42
)
{
    log(message);
}

export const shown = message;
