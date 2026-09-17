import('alpha');
import('beta');

// A dynamic import is a call, not a declaration — tsserver folds no run here.
const dynamic = import('gamma');
