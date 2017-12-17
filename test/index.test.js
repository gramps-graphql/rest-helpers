import GraphQLConnector from '../src/GraphQLConnector';
import GraphQLModel from '../src/GraphQLModel';
import * as helpers from '../src';

describe('@gramps/rest-helpers', () => {
  it('exports the GraphQLConnector', () => {
    expect(helpers.default.GraphQLConnector).toBe(GraphQLConnector);
  });

  it('exports the GraphQLModel', () => {
    expect(helpers.default.GraphQLModel).toBe(GraphQLModel);
  });
});
