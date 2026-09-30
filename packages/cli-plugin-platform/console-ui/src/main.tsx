import { createRoot } from 'react-dom/client';
import '@patternfly/react-core/dist/styles/base.css';
import { App } from './App';

const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(<App />);
}
