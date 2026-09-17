// Parity fixture: JSX constructs whose folding ranges must match the native
// VS Code (tsserver) output for .tsx files.
import React, { useState } from 'react';

type Item = { id: number; label: string };

export function App(props: { title: string; items: Item[] }) {
    const [open, setOpen] = useState<boolean>(false);
    const generic = <T,>(value: T): T[] => [value];
    const wide = generic<number>(1);

    return (
        <div className="app" data-open={open}>
            <h1>Don't panic — it's {props.title}</h1>
            <ul className="list">
                {props.items.map(item => {
                    return (
                        <li key={item.id} title="an item">
                            {item.label}
                        </li>
                    );
                })}
            </ul>
            <br />
            <Widget
                count={wide.length}
                label="multi
 line attribute"
                onPing={() => {
                    setOpen(!open);
                }}
            />
            <>
                <span>fragment child</span>
                {open && (
                    <section
                        id="details"
                    >
                        <p>a &lt; b and 5 {'>'} 3 stay text</p>
                    </section>
                )}
            </>
        </div>
    );
}

function Widget(props: { count: number; label: string; onPing: () => void }) {
    if (props.count > 1) {
        return <strong onClick={props.onPing}>{props.label}</strong>;
    }
    return (
        <em>
            small {`template ${props.count} inside`} text
        </em>
    );
}
