/*
 * Copyright (c) "Neo4j"
 * Neo4j Sweden AB [http://neo4j.com]
 *
 * This file is part of Neo4j.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ResolveTree } from "graphql-parse-resolve-info";
import { Node } from "../../classes";
import { Context, RelationField } from "../../types";
import {
    generateResultObject,
    getFieldType,
    AggregationType,
    wrapApocRun,
    getReferenceNode,
    getFieldByName,
} from "./utils";
import * as AggregationSubQueries from "./aggregation-sub-queries";
import { createFieldAggregationAuth, AggregationAuth } from "./field-aggregations-auth";
import { createMatchWherePattern } from "./aggregation-sub-queries";

const subQueryNodeAlias = "n";
const subQueryRelationAlias = "r";

export function createFieldAggregation({
    context,
    nodeLabel,
    node,
    field,
}: {
    context: Context;
    nodeLabel: string;
    node: Node;
    field: ResolveTree;
}): { query: string; params: Record<string, any> } | undefined {
    const relationAggregationField = node.relationFields.find((x) => {
        return `${x.fieldName}Aggregate` === field.name;
    });

    if (!relationAggregationField) return undefined;

    const referenceNode = getReferenceNode(context, relationAggregationField);
    if (!referenceNode) return undefined;

    const targetPattern = generateTargetPattern(nodeLabel, relationAggregationField, referenceNode);
    const fieldPathBase = `${node.name}${referenceNode.name}${relationAggregationField.fieldName}`;
    const aggregationField = field.fieldsByTypeName[`${fieldPathBase}AggregationResult`];

    const nodeFields: Record<string, ResolveTree> | undefined = getFieldByName("node", aggregationField)
        ?.fieldsByTypeName[`${fieldPathBase}AggregateSelection`];
    const edgeFields: Record<string, ResolveTree> | undefined = getFieldByName("edge", aggregationField)
        ?.fieldsByTypeName[`${fieldPathBase}EdgeAggregateSelection`];

    const authData = createFieldAggregationAuth({
        node: referenceNode,
        context,
        subQueryNodeAlias,
        nodeFields,
    });

    const matchWherePattern = createMatchWherePattern(targetPattern, authData);

    return {
        query: generateResultObject({
            count: getFieldByName("count", aggregationField)
                ? createCountQuery(matchWherePattern, subQueryNodeAlias, authData)
                : undefined,
            node: createAggregationQuery({
                matchWherePattern,
                fields: nodeFields,
                fieldAlias: subQueryNodeAlias,
                auth: authData,
            }),
            edge: createAggregationQuery({
                matchWherePattern,
                fields: edgeFields,
                fieldAlias: subQueryRelationAlias,
                auth: authData,
            }),
        }),
        params: authData.params,
    };
}

function generateTargetPattern(nodeLabel: string, relationField: RelationField, referenceNode: Node): string {
    const inStr = relationField.direction === "IN" ? "<-" : "-";
    const outStr = relationField.direction === "OUT" ? "->" : "-";
    const nodeOutStr = `(${subQueryNodeAlias}${referenceNode.labelString})`;

    return `(${nodeLabel})${inStr}[${subQueryRelationAlias}:${relationField.type}]${outStr}${nodeOutStr}`;
}

function createCountQuery(matchWherePattern: string, targetAlias: string, auth: AggregationAuth): string {
    const authParams = getAuthApocParams(auth);
    return wrapApocRun(AggregationSubQueries.countQuery(matchWherePattern, targetAlias), authParams);
}

function createAggregationQuery({
    matchWherePattern,
    fields,
    fieldAlias,
    auth,
}: {
    matchWherePattern: string;
    fields: Record<string, ResolveTree> | undefined;
    fieldAlias: string;
    auth: AggregationAuth;
}): string | undefined {
    if (!fields) return undefined;
    const authParams = getAuthApocParams(auth);

    const fieldsSubQueries = Object.values(fields).reduce((acc, field) => {
        const fieldType = getFieldType(field);
        acc[field.alias] = wrapApocRun(
            getAggregationSubQuery({
                matchWherePattern,
                fieldName: field.name,
                type: fieldType,
                targetAlias: fieldAlias,
            }),
            authParams
        );
        return acc;
    }, {} as Record<string, string>);

    return generateResultObject(fieldsSubQueries);
}

function getAggregationSubQuery({
    matchWherePattern,
    fieldName,
    type,
    targetAlias,
}: {
    matchWherePattern: string;
    fieldName: string;
    type: AggregationType | undefined;
    targetAlias: string;
}): string {
    switch (type) {
        case AggregationType.String:
        case AggregationType.Id:
            return AggregationSubQueries.stringAggregationQuery(matchWherePattern, fieldName, targetAlias);
        case AggregationType.Int:
        case AggregationType.BigInt:
        case AggregationType.Float:
            return AggregationSubQueries.numberAggregationQuery(matchWherePattern, fieldName, targetAlias);
        case AggregationType.DateTime:
            return AggregationSubQueries.dateTimeAggregationQuery(matchWherePattern, fieldName, targetAlias);
        default:
            return AggregationSubQueries.defaultAggregationQuery(matchWherePattern, fieldName, targetAlias);
    }
}

function getAuthApocParams(auth: AggregationAuth): Record<string, string> {
    const authParams: Record<string, string> = Object.keys(auth.params).reduce((acc, key) => {
        acc[key] = `$${key}`;
        return acc;
    }, {});
    if (auth.query) authParams.auth = "$auth";
    return authParams;
}
