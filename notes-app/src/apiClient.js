import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL;

export function createApiClient(token, { refreshToken } = {}) {
  const client = axios.create({ baseURL: API_URL });

  // attach Authorization header when token is present
  client.interceptors.request.use((config) => {
    if (token) {
      config.headers = config.headers || {};
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });

  // token refresh handling
  let isRefreshing = false;
  let subscribers = [];

  function onRefreshed(newToken) {
    subscribers.forEach((cb) => cb(newToken));
    subscribers = [];
  }

  function subscribe(cb) {
    subscribers.push(cb);
  }

  client.interceptors.response.use(
    (res) => res,
    async (error) => {
      const { config, response } = error;
      if (!response) return Promise.reject(error);

      // Only handle 401 once per request
      if (response.status === 401 && refreshToken) {
        if (config._retry) return Promise.reject(error);
        config._retry = true;

        if (isRefreshing) {
          // queue the request until refreshing is done
          return new Promise((resolve, reject) => {
            subscribe(async (newToken) => {
              if (!newToken) return reject(error);
              config.headers = config.headers || {};
              config.headers.Authorization = `Bearer ${newToken}`;
              try {
                const result = await client(config);
                resolve(result);
              } catch (err) {
                reject(err);
              }
            });
          });
        }

        isRefreshing = true;
        try {
          const newToken = await refreshToken();
          isRefreshing = false;
          if (!newToken) {
            onRefreshed(null);
            return Promise.reject(error);
          }

          // update token used by future requests
          token = newToken;
          client.defaults.headers.common.Authorization = `Bearer ${newToken}`;
          onRefreshed(newToken);

          // retry the original request with new token
          config.headers = config.headers || {};
          config.headers.Authorization = `Bearer ${newToken}`;
          return client(config);
        } catch (err) {
          isRefreshing = false;
          onRefreshed(null);
          return Promise.reject(err);
        }
      }

      return Promise.reject(error);
    },
  );

  return client;
}
