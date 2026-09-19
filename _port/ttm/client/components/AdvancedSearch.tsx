import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { formatDuration } from '../lib/utils';

interface SearchFilters {
  query: string;
  dateFrom: string;
  dateTo: string;
  customerId?: number;
  isBreak?: boolean;
  minDuration?: number;
  maxDuration?: number;
  sortBy: 'date' | 'duration' | 'customer';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}

interface SearchResult {
  id: number;
  checkIn: string;
  checkOut: string | null;
  isBreak: boolean;
  notes: string | null;
  customerId: number | null;
  customerName: string | null;
  duration: number;
}

interface SearchResponse {
  results: SearchResult[];
  pagination: {
    page: number;
    limit: number;
    totalCount: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
  filters: Partial<SearchFilters>;
}

async function searchTimeEntries(filters: Partial<SearchFilters>): Promise<SearchResponse> {
  const response = await fetch('/api/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${localStorage.getItem('token')}`
    },
    body: JSON.stringify(filters)
  });
  
  if (!response.ok) {
    throw new Error('Failed to search time entries');
  }
  
  return response.json();
}

export default function AdvancedSearch() {
  const [filters, setFilters] = useState<Partial<SearchFilters>>({
    query: '',
    dateFrom: '',
    dateTo: '',
    sortBy: 'date',
    sortOrder: 'desc',
    page: 1,
    limit: 20
  });

  const [isSearching, setIsSearching] = useState(false);

  const { data: searchResults, refetch } = useQuery({
    queryKey: ['search', filters],
    queryFn: () => searchTimeEntries(filters),
    enabled: isSearching
  });

  const handleSearch = () => {
    setIsSearching(true);
    refetch();
  };

  const handleFilterChange = (key: keyof SearchFilters, value: any) => {
    setFilters(prev => ({
      ...prev,
      [key]: value,
      page: key !== 'page' ? 1 : value // Reset page when changing other filters
    }));
  };

  const handlePageChange = (newPage: number) => {
    handleFilterChange('page', newPage);
    if (isSearching) {
      refetch();
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Advanced Search</CardTitle>
          <CardDescription>
            Search and filter your time entries with advanced criteria
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Search Text</label>
              <Input
                placeholder="Search in notes or customer names..."
                value={filters.query || ''}
                onChange={(e) => handleFilterChange('query', e.target.value)}
              />
            </div>
            
            <div>
              <label className="text-sm font-medium mb-2 block">From Date</label>
              <Input
                type="date"
                value={filters.dateFrom || ''}
                onChange={(e) => handleFilterChange('dateFrom', e.target.value)}
              />
            </div>
            
            <div>
              <label className="text-sm font-medium mb-2 block">To Date</label>
              <Input
                type="date"
                value={filters.dateTo || ''}
                onChange={(e) => handleFilterChange('dateTo', e.target.value)}
              />
            </div>
            
            <div>
              <label className="text-sm font-medium mb-2 block">Entry Type</label>
              <Select value={filters.isBreak?.toString() || 'all'} onValueChange={(value) => 
                handleFilterChange('isBreak', value === 'all' ? undefined : value === 'true')
              }>
                <SelectTrigger>
                  <SelectValue placeholder="All entries" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All entries</SelectItem>
                  <SelectItem value="false">Work entries only</SelectItem>
                  <SelectItem value="true">Break entries only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div>
              <label className="text-sm font-medium mb-2 block">Min Duration (minutes)</label>
              <Input
                type="number"
                placeholder="0"
                value={filters.minDuration || ''}
                onChange={(e) => handleFilterChange('minDuration', e.target.value ? parseInt(e.target.value) : undefined)}
              />
            </div>
            
            <div>
              <label className="text-sm font-medium mb-2 block">Max Duration (minutes)</label>
              <Input
                type="number"
                placeholder="No limit"
                value={filters.maxDuration || ''}
                onChange={(e) => handleFilterChange('maxDuration', e.target.value ? parseInt(e.target.value) : undefined)}
              />
            </div>
            
            <div>
              <label className="text-sm font-medium mb-2 block">Sort By</label>
              <Select value={filters.sortBy || 'date'} onValueChange={(value: 'date' | 'duration' | 'customer') => 
                handleFilterChange('sortBy', value)
              }>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="date">Date</SelectItem>
                  <SelectItem value="duration">Duration</SelectItem>
                  <SelectItem value="customer">Customer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div>
              <label className="text-sm font-medium mb-2 block">Sort Order</label>
              <Select value={filters.sortOrder || 'desc'} onValueChange={(value: 'asc' | 'desc') => 
                handleFilterChange('sortOrder', value)
              }>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="desc">Newest first</SelectItem>
                  <SelectItem value="asc">Oldest first</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          
          <Button onClick={handleSearch} className="w-full">
            Search Time Entries
          </Button>
        </CardContent>
      </Card>

      {searchResults && (
        <Card>
          <CardHeader>
            <CardTitle>Search Results</CardTitle>
            <CardDescription>
              Found {searchResults.pagination.totalCount} entries
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {searchResults.results.map((entry) => (
                <div key={entry.id} className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center space-x-4">
                    <Badge variant={entry.isBreak ? 'secondary' : 'default'}>
                      {entry.isBreak ? 'Break' : 'Work'}
                    </Badge>
                    <div>
                      <p className="font-medium">
                        {entry.customerName || 'No customer'}
                      </p>
                      <p className="text-sm text-gray-600">
                        {new Date(entry.checkIn).toLocaleString()}
                      </p>
                      {entry.notes && (
                        <p className="text-sm text-gray-500 italic">{entry.notes}</p>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-medium">
                      {formatDuration(entry.duration * 60)}
                    </p>
                    {entry.checkOut && (
                      <p className="text-sm text-gray-600">
                        Completed
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
            
            {searchResults.pagination.totalPages > 1 && (
              <div className="flex items-center justify-between mt-6">
                <Button
                  variant="outline"
                  disabled={!searchResults.pagination.hasPrev}
                  onClick={() => handlePageChange(searchResults.pagination.page - 1)}
                >
                  Previous
                </Button>
                <span className="text-sm text-gray-600">
                  Page {searchResults.pagination.page} of {searchResults.pagination.totalPages}
                </span>
                <Button
                  variant="outline"
                  disabled={!searchResults.pagination.hasNext}
                  onClick={() => handlePageChange(searchResults.pagination.page + 1)}
                >
                  Next
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}