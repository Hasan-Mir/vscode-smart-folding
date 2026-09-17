// Parity fixture: Allman declarations whose signatures span lines.
// - `function make( … )` has NO return annotation on the closing line, yet
//   tsserver emits ONE merged span (signature + body).
// - `lookup( … ): number` is an indented method declaration: the closing line
//   starts with whitespace, so the merge must not depend on column 0.
export function make(
    name: string
)
{
    return new Widget(name);
}

export class Widget
{
    private value = 0;

    lookup(
        key: string
    ): number
    {
        return this.value + key.length;
    }
}
