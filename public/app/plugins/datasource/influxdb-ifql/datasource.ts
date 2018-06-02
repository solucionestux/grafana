import _ from 'lodash';

import * as dateMath from 'app/core/utils/datemath';
import InfluxSeries from './influx_series';
import { parseResults, getTableModelFromResult, getTimeSeriesFromResult } from './response_parser';

const MAX_SERIES = 20;
export default class InfluxDatasource {
  type: string;
  urls: any;
  username: string;
  password: string;
  name: string;
  orgName: string;
  database: any;
  basicAuth: any;
  withCredentials: any;
  interval: any;
  supportAnnotations: boolean;
  supportMetrics: boolean;

  /** @ngInject */
  constructor(instanceSettings, private backendSrv, private templateSrv) {
    this.type = 'influxdb-ifql';
    this.urls = instanceSettings.url.split(',').map(url => url.trim());

    this.username = instanceSettings.username;
    this.password = instanceSettings.password;
    this.name = instanceSettings.name;
    this.orgName = instanceSettings.orgName || 'defaultorgname';
    this.database = instanceSettings.database;
    this.basicAuth = instanceSettings.basicAuth;
    this.withCredentials = instanceSettings.withCredentials;
    this.interval = (instanceSettings.jsonData || {}).timeInterval;
    this.supportAnnotations = true;
    this.supportMetrics = true;
  }

  query(options) {
    const targets = _.cloneDeep(options.targets);
    const queryTargets = targets.filter(t => t.query);
    if (queryTargets.length === 0) {
      return Promise.resolve({ data: [] });
    }

    // replace grafana variables
    const timeFilter = this.getTimeFilter(options);
    options.scopedVars.timeFilter = { value: timeFilter };

    const queries = queryTargets.map(target => {
      const { query, resultFormat } = target;

      // TODO replace templated variables
      // allQueries = this.templateSrv.replace(allQueries, scopedVars);

      if (resultFormat === 'table') {
        return (
          this._seriesQuery(query, options)
            .then(response => parseResults(response.data))
            // Keep only first result from each request
            .then(results => results[0])
            .then(getTableModelFromResult)
        );
      } else {
        return this._seriesQuery(query, options)
          .then(response => parseResults(response.data))
          .then(results => results.map(getTimeSeriesFromResult));
      }
    });

    return Promise.all(queries).then((series: any) => {
      let seriesList = _.flattenDeep(series).slice(0, MAX_SERIES);
      return { data: seriesList };
    });

    /*
    return this._seriesQuery(allQueries, options).then((data): any => {
      if (!data || !data.results) {
        return [];
      }

      var seriesList = [];
      for (i = 0; i < data.results.length; i++) {
        var result = data.results[i];
        if (!result || !result.series) {
          continue;
        }

        var target = queryTargets[i];
        var alias = target.alias;
        if (alias) {
          alias = this.templateSrv.replace(target.alias, options.scopedVars);
        }

        var influxSeries = new InfluxSeries({
          series: data.results[i].series,
          alias: alias,
        });

        switch (target.resultFormat) {
          case 'table': {
            seriesList.push(influxSeries.getTable());
            break;
          }
          default: {
            var timeSeries = influxSeries.getTimeSeries();
            for (y = 0; y < timeSeries.length; y++) {
              seriesList.push(timeSeries[y]);
            }
            break;
          }
        }
      }

      return { data: seriesList };
    });
    */
  }

  annotationQuery(options) {
    if (!options.annotation.query) {
      return Promise.reject({
        message: 'Query missing in annotation definition',
      });
    }

    var timeFilter = this.getTimeFilter({ rangeRaw: options.rangeRaw });
    var query = options.annotation.query.replace('$timeFilter', timeFilter);
    query = this.templateSrv.replace(query, null, 'regex');

    return this._seriesQuery(query, options).then(data => {
      if (!data || !data.results || !data.results[0]) {
        throw { message: 'No results in response from InfluxDB' };
      }
      return new InfluxSeries({
        series: data.results[0].series,
        annotation: options.annotation,
      }).getAnnotations();
    });
  }

  targetContainsTemplate(target) {
    for (let group of target.groupBy) {
      for (let param of group.params) {
        if (this.templateSrv.variableExists(param)) {
          return true;
        }
      }
    }

    for (let i in target.tags) {
      if (this.templateSrv.variableExists(target.tags[i].value)) {
        return true;
      }
    }

    return false;
  }

  metricFindQuery(query: string, options?: any) {
    var interpolated = this.templateSrv.replace(query, null, 'regex');

    return this._seriesQuery(interpolated, options).then(_.curry(parseResults)(query));
  }

  _seriesQuery(query: string, options?: any) {
    if (!query) {
      return Promise.resolve({ data: '' });
    }
    return this._influxRequest('POST', '/v1/query', { q: query }, options);
  }

  serializeParams(params) {
    if (!params) {
      return '';
    }

    return _.reduce(
      params,
      (memo, value, key) => {
        if (value === null || value === undefined) {
          return memo;
        }
        memo.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
        return memo;
      },
      []
    ).join('&');
  }

  testDatasource() {
    // const query = 'fromCSV(csv:"1,2") |> last()';
    const query = `from(db:"${this.database}") |> last()`;

    return this._influxRequest('POST', '/v1/query', { q: query })
      .then(res => {
        if (res && res.trim()) {
          return { status: 'success', message: 'Data source connected and database found.' };
        }
        return {
          status: 'error',
          message:
            'Data source connected, but has no data. Verify the "Database" field and make sure the database has data.',
        };
      })
      .catch(err => {
        return { status: 'error', message: err.message };
      });
  }

  _influxRequest(method: string, url: string, data: any, options?: any) {
    // Round-robin
    // const currentUrl = this.urls.shift();
    // this.urls.push(currentUrl);
    const currentUrl = this.urls[0];

    let params: any = {
      orgName: this.orgName,
    };

    if (this.username) {
      params.u = this.username;
      params.p = this.password;
    }

    if (options && options.database) {
      params.db = options.database;
    } else if (this.database) {
      params.db = this.database;
    }

    // data sent as GET param
    _.extend(params, data);
    data = null;

    let req: any = {
      method: method,
      url: currentUrl + url,
      params: params,
      data: data,
      precision: 'ms',
      inspect: { type: this.type },
      paramSerializer: this.serializeParams,
    };

    req.headers = req.headers || {};
    if (this.basicAuth || this.withCredentials) {
      req.withCredentials = true;
    }
    if (this.basicAuth) {
      req.headers.Authorization = this.basicAuth;
    }

    return this.backendSrv.datasourceRequest(req).then(
      result => {
        return result;
      },
      function(err) {
        if (err.status !== 0 || err.status >= 300) {
          if (err.data && err.data.error) {
            throw {
              message: 'InfluxDB Error: ' + err.data.error,
              data: err.data,
              config: err.config,
            };
          } else {
            throw {
              message: 'Network Error: ' + err.statusText + '(' + err.status + ')',
              data: err.data,
              config: err.config,
            };
          }
        }
      }
    );
  }

  getTimeFilter(options) {
    var from = this.getInfluxTime(options.rangeRaw.from, false);
    var until = this.getInfluxTime(options.rangeRaw.to, true);
    var fromIsAbsolute = from[from.length - 1] === 'ms';

    if (until === 'now()' && !fromIsAbsolute) {
      return 'time >= ' + from;
    }

    return 'time >= ' + from + ' and time <= ' + until;
  }

  getInfluxTime(date, roundUp) {
    if (_.isString(date)) {
      if (date === 'now') {
        return 'now()';
      }

      var parts = /^now-(\d+)([d|h|m|s])$/.exec(date);
      if (parts) {
        var amount = parseInt(parts[1]);
        var unit = parts[2];
        return 'now() - ' + amount + unit;
      }
      date = dateMath.parse(date, roundUp);
    }

    return date.valueOf() + 'ms';
  }
}
