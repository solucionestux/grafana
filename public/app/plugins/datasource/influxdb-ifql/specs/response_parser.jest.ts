import { parseResults, getTableModelFromResult, getTimeSeriesFromResult } from '../response_parser';
import response from './sample_response_csv';

describe('influxdb ifql response parser', () => {
  describe('parseResults()', () => {
    it('expects three results', () => {
      const results = parseResults(response);
      expect(results.length).toBe(14);
    });
  });

  describe('getTableModelFromResult()', () => {
    it('expects a table model', () => {
      const results = parseResults(response);
      const table = getTableModelFromResult(results[0]);
      expect(table.columns.length).toBe(6);
      expect(table.rows.length).toBe(300);
    });
  });

  describe('getTimeSeriesFromResult()', () => {
    it('expects time series', () => {
      const results = parseResults(response);
      const series = getTimeSeriesFromResult(results[0]);
      expect(series.length).toBe(50);
      expect(series[0].datapoints.length).toBe(6);
    });
  });
});
