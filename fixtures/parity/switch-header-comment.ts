export function labelFor(value: number): string
{
    switch (value) // route action — comments must not hide the case folds
    {
        case 1:
            return 'one';
        case 2:
            return 'two';
        default:
            return 'many';
    }
}
