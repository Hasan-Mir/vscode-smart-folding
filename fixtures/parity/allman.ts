// Allman fixture: brace-on-next-line folds must start at the statement
// header line — exactly where tsserver begins its outlining spans.
export function topLevel(
    first: string,
    second: number
): string
{
    const values = [
        1,
        2,
    ];
    if (values.length > 0)
    {
        values.forEach(v =>
        {
            console.log(v);
        });
    }
    return first;
}

export class Box
{
    private value = 0;

    get(): number
    {
        return this.value;
    }
}

export function risky(): void
{
    try
    {
        mightThrow();
    }
    catch (error)
    {
        console.error(error);
    }
    finally
    {
        cleanup();
    }
}