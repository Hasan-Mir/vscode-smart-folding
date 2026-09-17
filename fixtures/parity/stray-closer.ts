// Parity fixture: a malformed stray `)` must not destroy the function fold
// (F-1). tsserver is error-tolerant and still emits the function span.
export function demo(): number {
    const values = [
        1,
        2,
    );
    return values.length;
}