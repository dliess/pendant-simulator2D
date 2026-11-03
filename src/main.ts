import './style.css';
import './dev.css';
import { mountSimulator } from './simulator';

const container = document.querySelector<HTMLElement>('#app');
if (!container) throw new Error('Missing simulator development container');
const cleanup = mountSimulator(container);

if (import.meta.hot) import.meta.hot.dispose(cleanup);
