import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './themes.css';
import './landing.css';
import './app.css';

async function start() {
  if (new URLSearchParams(location.search).has('demo')) (await import('./demo/mock')).install();
  createRoot(document.getElementById('root')!).render(<App />);
}
void start();
