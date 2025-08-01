import { useEffect, useState } from 'react';
import { FaRegCopy } from 'react-icons/fa';
import { useAuthState } from './authState';

interface ITodo {
  id: number;
  task: string;
  completed: boolean;
}

function Todos() {
  const [todoList, setTodoList] = useState<ITodo[]>([]);
  const [newTask, setNewTask] = useState<string>('');
  const { authState } = useAuthState();
  const [showCopyTip, setShowCopyTip] = useState<number | null>(null);

  const API_BASE_URL = '/api/todos';

  useEffect(() => {
    const getTodos = async () => {
      try {
        const response = await fetch(API_BASE_URL, {
          credentials: 'same-origin',
          mode: 'same-origin',
        });
        const res = await response.json();
        setTodoList(res.todos);
      } catch (error: unknown) {
        console.error(error);
      }
    };
    if (authState.isAuthenticated) {
      getTodos();
    }
  }, [authState.isAuthenticated]);

  const onNewTask = () => {
    const apiCall = async () => {
      try {
        const res = await fetch(API_BASE_URL, {
          method: 'POST',
          credentials: 'same-origin',
          mode: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ task: newTask }),
        });

        const todo = await res.json();
        setTodoList([todo, ...todoList]);
        setNewTask('');
      } catch (error: unknown) {
        console.error(error);
      }
    };
    apiCall();
  };

  const onChangeTaskStatus = (todo: ITodo) => {
    const { completed } = todo;
    const url = `${API_BASE_URL}/${todo.id}`;
    const apiCall = async () => {
      try {
        const res = await fetch(url, {
          method: 'PUT',
          credentials: 'same-origin',
          mode: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...todo, completed: !completed }),
        });
        const updatedTodo = await res.json();
        if (!completed) {
          setTodoList([...todoList.filter((t) => t.id !== todo.id), updatedTodo]);
        } else {
          setTodoList([updatedTodo, ...todoList.filter((t) => t.id !== todo.id)]);
        }
      } catch (error: unknown) {
        console.error(error);
      }
    };

    apiCall();
  };

  const onDeleteTask = (todo: ITodo) => {
    const url = `${API_BASE_URL}/${todo.id}`;

    const apiCall = async () => {
      try {
        await fetch(url, {
          method: 'DELETE',
          credentials: 'same-origin',
          mode: 'same-origin',
        });
        setTodoList(todoList.filter((t) => t.id !== todo.id));
      } catch (error: unknown) {
        console.error(error);
      }
    };

    apiCall();
  };

  return (
    <div className="w-full">
      {authState.isAuthenticated && (
        <>
          <h1 className="text-left mt-24 mb-6 w-full mx-auto w-1200 text-stone-900 text-5xl font-bold font-['Inter']">
            Today
          </h1>
          <div className="todo-card w-full text-left mx-auto border border-slate-200">
            <div className="w-full px-8 py-6 flex justify-between gap-6">
              <input
                className="w-5/6 text-m text-slate-900 placeholder-slate-400 rounded-md py-2 pl-2 ring-1 border-none bg-gray-50 ring-slate-200"
                type="text"
                placeholder="Your task here"
                value={newTask}
                onChange={(event) => setNewTask(event.target.value)}
              />
              <button
                type="button"
                className="add-task-btn w-2/6 py-3 rounded-md text-white"
                onClick={onNewTask}
                disabled={!newTask}
              >
                + Add task
              </button>
            </div>
            {todoList.length > 0 ? (
              <div className="bg-slate-50 px-4 py-3 mb-2">
                <ul className="max-w">
                  {todoList.map((todo) => (
                    <li
                      key={todo.id}
                      className="todo-item p-3 flex justify-between items-center mb-2 bg-white shadow-sm border border-slate-200 last:mb-0 transition-all duration-200"
                      style={{ minHeight: '3.2rem' }}
                    >
                      <div className="flex items-center w-full">
                        <input
                          type="checkbox"
                          id={`check-${todo.id}`}
                          className="todo-checkbox rounded-full mr-4 w-6 h-6 accent-teal-500 transition-all duration-200"
                          checked={todo.completed}
                          onChange={() => onChangeTaskStatus(todo)}
                        />
                        <label
                          htmlFor={`check-${todo.id}`}
                          className={
                            todo.completed
                              ? 'line-through text-slate-400 opacity-70 transition-all duration-200'
                              : 'text-slate-800'
                          }
                          style={{ width: '100%' }}
                        >
                          <a
                            className="hover:text-blue-700 break-words block w-full"
                            href={`/todos/${todo.id}`}
                          >
                            {todo.task}
                          </a>
                        </label>
                      </div>
                      <div className="flex items-center ml-2">
                        {/* Copy tip feedback */}
                        {showCopyTip !== null && (
                          <div className="fixed left-1/2 top-8 z-50 -translate-x-1/2 bg-black text-white px-4 py-2 rounded shadow-lg text-sm animate-fade-in-out">
                            Link copied!
                          </div>
                        )}
                        <button
                          type="button"
                          aria-label="Copy Link"
                          onClick={() => {
                            navigator.clipboard.writeText(
                              `${window.location.href}todos/${todo.id}`
                            );
                            setShowCopyTip(todo.id);
                            setTimeout(() => setShowCopyTip(null), 1200);
                          }}
                          className="inline-block focus:outline-none pr-2 hover:text-black inline-flex items-center me-2"
                        >
                          <FaRegCopy />
                        </button>
                        <button
                          type="button"
                          aria-label="Delete Todo"
                          className="rounded-full p-2 hover:bg-red-100 transition-colors"
                          onClick={() => onDeleteTask(todo)}
                        >
                          <svg
                            className="h-7 fill-red-500"
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 96 960 960"
                          >
                            <path d="M261 936q-24.75 0-42.375-17.625T201 876V306h-41v-60h188v-30h264v30h188v60h-41v570q0 24-18 42t-42 18H261Zm438-630H261v570h438V306ZM367 790h60V391h-60v399Zm166 0h60V391h-60v399ZM261 306v570-570Z" />
                          </svg>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="w-3/5 mx-24 py-6 text-center text-zinc-800 text-base font-semibold font-['Inter']">
                Plan your day: What stuff do you need to get done? Add a task to get started!
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default Todos;
