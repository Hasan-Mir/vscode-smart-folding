// Parity fixture: a broad mix of constructs whose folding ranges must match
// what VS Code's built-in TypeScript folding produces.
import * as fs from 'fs';
import { join, resolve } from 'path';
import {
    createHash,
    randomBytes,
} from 'crypto';

// #region types
/**
 * A multi-line JSDoc comment.
 * It should fold as a comment.
 */
interface Shape {
    name: string;
    area(): number;
    corners?: number;
}

enum Color {
    Red,
    Green,
    Blue,
}
// #endregion

/*
 * Plain block comment,
 * also multi-line.
 */
class Circle implements Shape {
    name = 'circle';
    #secret = 42;

    constructor(
        private radius: number,
        public label: string
    ) {
        this.name = label;
    }

    area(): number {
        return Math.PI * this.radius ** 2;
    }

    #hidden(): number {
        return this.#secret;
    }

    get description(): string {
        return `r=${this.radius}`;
    }
}

function classify(value: number, text: string): string {
    // Consecutive single-line comments
    // should fold together as one
    // comment block.
    const matcher = /^[a-z{(\["']+$/i;
    const divide = value / 2 / 3;
    if (matcher.test(text)) {
        try {
            switch (value) {
                case 1:
                    console.log('one');
                    break;
                case 2: {
                    const nested = {
                        deep: [
                            1,
                            2,
                            3,
                        ],
                    };
                    console.log(nested, divide);
                    break;
                }
                default:
                    console.log('other');
            }
        } catch (error) {
            console.error(error);
        } finally {
            console.log('done');
        }
    } else if (value > 0) {
        for (let i = 0; i < value; i++) {
            while (Math.random() > 0.5) {
                console.log(i);
            }
        }
    } else {
        do {
            value += 1;
        } while (value < 0);
    }
    return text.replace(/[{}"']/g, '');
}

const template = `first line
second ${classify(
    1,
    'x'
)} interpolated
last line
`;

const config = {
    numbers: [
        1,
        2,
    ],
    nested: {
        deep: true,
    },
    factory: (
        a: number,
        b: number
    ) => {
        return a + b;
    },
};

const result = classify(
    config.numbers.length,
    template
);

(function iife() {
    console.log(result, Color.Red, new Circle(1, 'c').area());
})();

export const arrow = async (input: string[]): Promise<string[]> => {
    return input
        .filter(item => {
            return item.length > 0;
        })
        .map(item => item.toUpperCase());
};
