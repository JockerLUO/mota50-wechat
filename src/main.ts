import './style.css';
import { Game } from './app';
import { host } from './host';

Game.create()
  .then((game) => {
    host().bootSettled();
    // 便于在控制台 / 小游戏调试器里检查状态与数据
    host().expose('mota', { game });
  })
  .catch((err: unknown) => {
    console.error(err);
    host().bootSettled(err);
  });
