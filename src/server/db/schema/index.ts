export * from './enums';
export * from './reference';
export * from './identity';
export * from './profiles';
export * from './institutions';
export * from './programmes';
export * from './scholarships';
export * from './verification';
export * from './documents';
export * from './applications';
export * from './planner';
export * from './ai';
export * from './outbox';
export * from './relations';

import * as ai from './ai';
import * as applications from './applications';
import * as documents from './documents';
import * as enums from './enums';
import * as identity from './identity';
import * as institutions from './institutions';
import * as outbox from './outbox';
import * as planner from './planner';
import * as profiles from './profiles';
import * as programmes from './programmes';
import * as reference from './reference';
import * as relations from './relations';
import * as scholarships from './scholarships';
import * as verification from './verification';

export const schema = {
  ...enums,
  ...reference,
  ...identity,
  ...profiles,
  ...institutions,
  ...programmes,
  ...scholarships,
  ...verification,
  ...documents,
  ...applications,
  ...planner,
  ...ai,
  ...outbox,
  ...relations,
};
